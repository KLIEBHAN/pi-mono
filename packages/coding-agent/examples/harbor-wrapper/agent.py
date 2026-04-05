"""
Harbor wrapper for pi coding agent.

Runs pi in RPC mode as a subprocess inside the Harbor sandbox environment,
bridging Harbor's agent interface with pi's RPC protocol. Pi uses its
terminal-bench extension for environment bootstrapping, prompt optimizations,
completion verification, and tmux-based terminal interaction.

Usage:
    harbor run \
        --agent-import-path agent:PiAgent \
        -d terminal-bench@2.0 \
        -m anthropic/claude-sonnet-4-20250514 \
        -e runloop \
        -n 20 \
        --n-attempts 5

Requires:
    - pi installed globally: npm install -g @mariozechner/pi-coding-agent
    - harbor installed: pip install harbor
    - terminal-bench extension at ~/.pi/agent/extensions/terminal-bench.ts
"""

import asyncio
import json
import logging
import shutil
import time
from pathlib import Path
from typing import Any

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

_LOGGER = logging.getLogger(__name__)

# How long to wait for pi to become idle after sending a prompt (seconds).
# Terminal-bench tasks can take a very long time.
TASK_TIMEOUT_SEC = 30 * 60  # 30 minutes


def _find_pi_binary() -> str:
    """Locate the pi binary."""
    pi_path = shutil.which("pi")
    if pi_path:
        return pi_path
    # Common npm global install locations
    for candidate in [
        Path.home() / ".npm-global" / "bin" / "pi",
        Path("/usr/local/bin/pi"),
        Path("/usr/bin/pi"),
    ]:
        if candidate.exists():
            return str(candidate)
    raise FileNotFoundError(
        "Could not find 'pi' binary. Install with: npm install -g @mariozechner/pi-coding-agent"
    )


def _parse_model_arg(model_name: str | None) -> tuple[str | None, str | None]:
    """Parse 'provider/model' into (provider, model) tuple."""
    if not model_name:
        return None, None
    if "/" in model_name:
        provider, model_id = model_name.split("/", 1)
        return provider, model_id
    return None, model_name


class PiRpcClient:
    """Manages a pi subprocess in RPC mode and provides a simple send/receive API."""

    def __init__(self, proc: asyncio.subprocess.Process):
        self._proc = proc
        self._reader_task: asyncio.Task | None = None
        self._response_waiters: dict[str, asyncio.Future] = {}
        self._event_queue: asyncio.Queue = asyncio.Queue()
        self._req_counter = 0
        self._started = False

    async def start(self) -> None:
        """Start the background reader task."""
        if self._started:
            return
        self._started = True
        self._reader_task = asyncio.create_task(self._read_loop())

    async def _read_loop(self) -> None:
        """Read lines from pi's stdout and dispatch responses vs events."""
        assert self._proc.stdout is not None
        while True:
            raw = await self._proc.stdout.readline()
            if not raw:
                break
            line = raw.decode("utf-8").strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                _LOGGER.warning("Non-JSON line from pi: %s", line[:200])
                continue

            msg_type = msg.get("type", "")

            # Responses have type "response" and carry an "id" field
            if msg_type == "response":
                req_id = msg.get("id")
                if req_id and req_id in self._response_waiters:
                    self._response_waiters[req_id].set_result(msg)
                    del self._response_waiters[req_id]
                continue

            # Extension UI requests — auto-cancel dialogs
            if msg_type == "extension_ui_request":
                method = msg.get("method", "")
                ui_id = msg.get("id")
                if method in ("select", "confirm", "input", "editor") and ui_id:
                    # Cancel all dialog prompts — pi runs unattended
                    cancel_msg = {
                        "type": "extension_ui_response",
                        "id": ui_id,
                        "cancelled": True,
                    }
                    await self._send_raw(cancel_msg)
                continue

            # Everything else is an event
            await self._event_queue.put(msg)

    async def _send_raw(self, obj: dict) -> None:
        """Send a JSON line to pi's stdin."""
        assert self._proc.stdin is not None
        data = json.dumps(obj) + "\n"
        self._proc.stdin.write(data.encode("utf-8"))
        await self._proc.stdin.drain()

    async def send_command(self, cmd: dict, timeout: float = 30.0) -> dict:
        """Send a command and wait for its response."""
        self._req_counter += 1
        req_id = f"req-{self._req_counter}"
        cmd["id"] = req_id

        loop = asyncio.get_event_loop()
        future: asyncio.Future = loop.create_future()
        self._response_waiters[req_id] = future

        await self._send_raw(cmd)

        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._response_waiters.pop(req_id, None)
            raise

    async def wait_for_event(
        self,
        event_type: str,
        timeout: float | None = None,
    ) -> dict | None:
        """Wait for a specific event type. Returns None on timeout."""
        deadline = time.monotonic() + timeout if timeout else None
        while True:
            remaining = None
            if deadline:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
            try:
                event = await asyncio.wait_for(
                    self._event_queue.get(),
                    timeout=remaining,
                )
                if event.get("type") == event_type:
                    return event
                # Discard non-matching events (they're consumed)
            except asyncio.TimeoutError:
                return None

    async def drain_until_idle(
        self,
        timeout: float = TASK_TIMEOUT_SEC,
        on_event: Any = None,
    ) -> list[dict]:
        """Drain events until agent_end, collecting all events."""
        events: list[dict] = []
        deadline = time.monotonic() + timeout

        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                _LOGGER.warning("Timeout waiting for agent_end")
                break

            try:
                event = await asyncio.wait_for(
                    self._event_queue.get(),
                    timeout=min(remaining, 5.0),
                )
            except asyncio.TimeoutError:
                # Check if process died
                if self._proc.returncode is not None:
                    _LOGGER.warning("pi process exited with code %d", self._proc.returncode)
                    break
                continue

            events.append(event)
            if on_event:
                on_event(event)

            if event.get("type") == "agent_end":
                break

        return events

    async def stop(self) -> None:
        """Terminate the pi process."""
        if self._proc.returncode is None:
            try:
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), timeout=10)
            except (asyncio.TimeoutError, ProcessLookupError):
                self._proc.kill()
        if self._reader_task:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except asyncio.CancelledError:
                pass


class PiAgent(BaseAgent):
    """Harbor agent that delegates to pi in RPC mode."""

    SUPPORTS_ATIF: bool = False  # We don't produce ATIF trajectories

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._rpc: PiRpcClient | None = None
        self._pi_proc: asyncio.subprocess.Process | None = None

    @staticmethod
    def name() -> str:
        return "pi-coding-agent"

    def version(self) -> str | None:
        return "1.0.0"

    async def setup(self, environment: BaseEnvironment) -> None:
        """Start pi in RPC mode."""
        pi_bin = _find_pi_binary()
        provider, model_id = _parse_model_arg(self.model_name)

        cmd = [
            pi_bin,
            "--mode", "rpc",
            "--no-session",
            "--terminal-bench",
            "--thinking", "high",
        ]

        if provider:
            cmd.extend(["--provider", provider])
        if model_id:
            cmd.extend(["--model", model_id])

        _LOGGER.info("Starting pi: %s", " ".join(cmd))

        self._pi_proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        self._rpc = PiRpcClient(self._pi_proc)
        await self._rpc.start()

        # Wait briefly for pi to initialize
        await asyncio.sleep(2)

        _LOGGER.info("pi started (pid=%d)", self._pi_proc.pid or 0)

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        """Send the task instruction to pi and wait for completion."""
        if not self._rpc:
            raise RuntimeError("pi not started — call setup() first")

        # Track metrics
        total_input_tokens = 0
        total_output_tokens = 0
        total_cache_tokens = 0
        total_cost = 0.0
        start_time = time.time()

        def on_event(event: dict) -> None:
            nonlocal total_input_tokens, total_output_tokens, total_cache_tokens, total_cost

            event_type = event.get("type", "")

            # Extract token usage from message_end events for assistant messages
            if event_type == "message_end":
                message = event.get("message", {})
                if message.get("role") == "assistant":
                    usage = message.get("usage", {})
                    total_input_tokens += usage.get("input", 0)
                    total_output_tokens += usage.get("output", 0)
                    total_cache_tokens += usage.get("cacheRead", 0)
                    cost = usage.get("cost", {})
                    total_cost += cost.get("total", 0)

            # Log tool calls for observability
            if event_type == "tool_execution_start":
                tool_name = event.get("toolName", "?")
                _LOGGER.debug("Tool call: %s", tool_name)

            if event_type == "tool_execution_end":
                tool_name = event.get("toolName", "?")
                is_error = event.get("isError", False)
                if is_error:
                    _LOGGER.warning("Tool error: %s", tool_name)

        # Send the task instruction
        _LOGGER.info("Sending task instruction (%d chars)", len(instruction))
        response = await self._rpc.send_command(
            {"type": "prompt", "message": instruction},
            timeout=30,
        )

        if not response.get("success"):
            error = response.get("error", "unknown error")
            _LOGGER.error("Failed to send prompt: %s", error)
            return

        # Wait for the agent to finish
        events = await self._rpc.drain_until_idle(
            timeout=TASK_TIMEOUT_SEC,
            on_event=on_event,
        )

        elapsed = time.time() - start_time
        _LOGGER.info(
            "pi finished in %.1fs — %d events, %d input tokens, %d output tokens, $%.4f",
            elapsed,
            len(events),
            total_input_tokens,
            total_output_tokens,
            total_cost,
        )

        # Populate Harbor's AgentContext
        context.n_input_tokens = total_input_tokens
        context.n_output_tokens = total_output_tokens
        context.n_cache_tokens = total_cache_tokens
        context.cost_usd = total_cost if total_cost > 0 else None

        # Stop pi
        try:
            await self._rpc.stop()
        except Exception:
            _LOGGER.debug("Error stopping pi", exc_info=True)
