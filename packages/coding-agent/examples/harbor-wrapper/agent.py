"""
Harbor wrapper for pi coding agent.

Installs pi inside the Harbor sandbox container and runs it in print mode.
Pi uses its terminal-bench extension for environment bootstrapping, prompt
optimizations, completion verification, and tmux-based terminal interaction.

Usage:
    harbor run \
        --agent-import-path agent:PiAgent \
        -d terminal-bench@2.0 \
        -m anthropic/claude-opus-4-6 \
        -e runloop \
        -n 20 \
        --n-attempts 5

Requires:
    - harbor: pip install harbor
    - terminal-bench extension at ~/.pi/agent/extensions/terminal-bench.ts
      (or next to this file at ../extensions/terminal-bench.ts)
    - auth.json at ~/.pi/agent/auth.json (for subscription auth)
      OR ANTHROPIC_API_KEY set in environment
"""

import base64
import json
import logging
import os
import time
from pathlib import Path

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

_LOGGER = logging.getLogger(__name__)

# Per-task timeout in seconds (30 minutes).
TASK_TIMEOUT_SEC = 30 * 60

# Node.js version to install in the container.
NODE_VERSION = "22.16.0"

# Paths on host
_HOST_AUTH = Path.home() / ".pi" / "agent" / "auth.json"
_HOST_EXTENSION = Path(__file__).parent.parent / "extensions" / "terminal-bench.ts"
_HOST_EXTENSION_GLOBAL = Path.home() / ".pi" / "agent" / "extensions" / "terminal-bench.ts"

# Paths inside the container
_REMOTE_PI_DIR = "/root/.pi/agent"
_REMOTE_AUTH = f"{_REMOTE_PI_DIR}/auth.json"
_REMOTE_EXT_DIR = f"{_REMOTE_PI_DIR}/extensions"
_REMOTE_EXT = f"{_REMOTE_EXT_DIR}/terminal-bench.ts"
_REMOTE_TASK = "/tmp/pi-task.txt"
_REMOTE_ERRORS = "/tmp/pi-errors.log"
_REMOTE_WORKDIR = "/app"
_REMOTE_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR"


def _find_extension() -> Path | None:
    """Locate the terminal-bench extension on the host."""
    for candidate in [_HOST_EXTENSION, _HOST_EXTENSION_GLOBAL]:
        if candidate.exists():
            return candidate
    return None


def _parse_model_arg(model_name: str | None) -> tuple[str | None, str | None]:
    """Parse 'provider/model-id' into (provider, model_id)."""
    if not model_name:
        return None, None
    if "/" in model_name:
        provider, model_id = model_name.split("/", 1)
        return provider, model_id
    return None, model_name


def _read_host_auth() -> dict[str, object] | None:
    """Load host auth.json if present and valid."""
    if not _HOST_AUTH.exists():
        return None

    try:
        data = json.loads(_HOST_AUTH.read_text())
    except Exception:
        _LOGGER.warning("Failed to parse %s", _HOST_AUTH, exc_info=True)
        return None

    if not isinstance(data, dict):
        _LOGGER.warning("Ignoring non-object auth.json at %s", _HOST_AUTH)
        return None

    return data


def _get_oauth_access_token(auth_data: dict[str, object] | None, provider: str) -> str | None:
    """Extract a non-expired OAuth access token from auth.json."""
    if not auth_data:
        return None

    entry = auth_data.get(provider)
    if not isinstance(entry, dict):
        return None

    if entry.get("type") != "oauth":
        return None

    access = entry.get("access")
    if not isinstance(access, str) or not access:
        return None

    expires = entry.get("expires")
    if isinstance(expires, (int, float)) and expires <= time.time() * 1000:
        _LOGGER.warning(
            "%s OAuth access token in auth.json is expired; relying on uploaded auth.json instead",
            provider,
        )
        return None

    return access


class PiAgent(BaseAgent):
    """Harbor agent that installs and runs pi inside the sandbox container."""

    SUPPORTS_ATIF: bool = False

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._provider, self._model_id = _parse_model_arg(self.model_name)
        self._host_auth = _read_host_auth()
        self._anthropic_oauth_token = _get_oauth_access_token(self._host_auth, "anthropic")

    @staticmethod
    def name() -> str:
        return "pi-coding-agent"

    def version(self) -> str | None:
        return "1.0.0"

    async def setup(self, environment: BaseEnvironment) -> None:
        """Install Node.js, pi, tmux, and upload config into the container."""
        _LOGGER.info("Setting up pi in container...")

        # 1. System dependencies (curl for Node.js download, tmux for tmux tools)
        _LOGGER.info("Installing system dependencies...")
        await environment.exec(
            "apt-get update -qq && apt-get install -y -qq curl tmux xz-utils > /dev/null 2>&1",
            timeout_sec=180,
        )

        # 2. Node.js from binary tarball (faster than nodesource apt repo)
        _LOGGER.info("Installing Node.js %s...", NODE_VERSION)
        await environment.exec(
            "ARCH=$(uname -m); "
            "case $ARCH in x86_64) NA=x64;; aarch64|arm64) NA=arm64;; *) NA=x64;; esac; "
            f'curl -fsSL "https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-${{NA}}.tar.xz" '
            "| tar -xJ -C /usr/local --strip-components=1",
            timeout_sec=120,
        )

        # Verify node works
        result = await environment.exec("node --version", timeout_sec=10)
        _LOGGER.info("Node.js installed: %s", (result.stdout or "").strip())

        # 3. Install pi
        _LOGGER.info("Installing pi coding agent...")
        await environment.exec(
            "npm install -g @mariozechner/pi-coding-agent 2>&1 | tail -5",
            timeout_sec=300,
        )

        result = await environment.exec("pi --version", timeout_sec=10)
        _LOGGER.info("pi installed: %s", (result.stdout or "").strip())

        # 4. Upload terminal-bench extension
        ext_path = _find_extension()
        if ext_path:
            _LOGGER.info("Uploading terminal-bench extension from %s", ext_path)
            await environment.exec(f"mkdir -p {_REMOTE_EXT_DIR}", timeout_sec=5)
            await environment.upload_file(str(ext_path), _REMOTE_EXT)
        else:
            _LOGGER.warning(
                "terminal-bench extension not found. "
                "Expected at %s or %s",
                _HOST_EXTENSION,
                _HOST_EXTENSION_GLOBAL,
            )

        # 5. Upload auth.json for subscription auth (if available)
        if _HOST_AUTH.exists():
            _LOGGER.info("Uploading auth.json for subscription auth")
            await environment.exec(f"mkdir -p {_REMOTE_PI_DIR}", timeout_sec=5)
            await environment.upload_file(str(_HOST_AUTH), _REMOTE_AUTH)

            if self._anthropic_oauth_token:
                _LOGGER.info("Will inject Anthropic OAuth access token via environment")
        elif os.environ.get("ANTHROPIC_OAUTH_TOKEN"):
            _LOGGER.info("Using ANTHROPIC_OAUTH_TOKEN from environment")
        elif os.environ.get("ANTHROPIC_API_KEY"):
            _LOGGER.info("Using ANTHROPIC_API_KEY from environment")
        else:
            _LOGGER.warning(
                "No auth.json, ANTHROPIC_OAUTH_TOKEN, or ANTHROPIC_API_KEY. "
                "Pi may not be able to authenticate."
            )

        _LOGGER.info("Setup complete.")

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        """Run pi in print mode inside the container."""
        _LOGGER.info("Running pi on task (%d chars)", len(instruction))

        # Write instruction to file via base64 to avoid any shell escaping issues
        encoded = base64.b64encode(instruction.encode("utf-8")).decode("ascii")
        await environment.exec(
            f"echo '{encoded}' | base64 -d > {_REMOTE_TASK}",
            timeout_sec=10,
        )

        # Build pi command
        cmd_parts = [
            "pi", "-p",
            "--terminal-bench",
            "--thinking", "high",
            "--no-session",
        ]

        if self._provider:
            cmd_parts.extend(["--provider", self._provider])
        if self._model_id:
            cmd_parts.extend(["--model", self._model_id])

        # Pass auth + config via env vars.
        env_vars: dict[str, str] = {
            _REMOTE_AGENT_DIR_ENV: _REMOTE_PI_DIR,
        }
        for key in [
            "ANTHROPIC_OAUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "GEMINI_API_KEY",
            "XAI_API_KEY",
        ]:
            val = os.environ.get(key)
            if val:
                env_vars[key] = val

        if (
            "ANTHROPIC_OAUTH_TOKEN" not in env_vars
            and "ANTHROPIC_API_KEY" not in env_vars
            and self._anthropic_oauth_token
        ):
            env_vars["ANTHROPIC_OAUTH_TOKEN"] = self._anthropic_oauth_token

        # @file passes file content as the prompt
        cmd_parts.append(f"@{_REMOTE_TASK}")

        # Redirect stderr to file for debugging
        cmd = " ".join(cmd_parts) + f" 2>{_REMOTE_ERRORS}"

        remote_cwd = _REMOTE_WORKDIR if await environment.is_dir(_REMOTE_WORKDIR) else None
        if remote_cwd:
            _LOGGER.info("Executing in working directory: %s", remote_cwd)
        else:
            _LOGGER.warning("Working directory %s not found; using container default", _REMOTE_WORKDIR)

        _LOGGER.info("Executing: %s", cmd)

        result = await environment.exec(
            cmd,
            cwd=remote_cwd,
            env=env_vars,
            timeout_sec=TASK_TIMEOUT_SEC,
        )

        # Log result
        exit_code = result.return_code
        stdout_preview = (result.stdout or "")[:500]
        _LOGGER.info("pi exited with code %s", exit_code)
        if stdout_preview:
            _LOGGER.info("pi output (first 500 chars): %s", stdout_preview)

        # Download error log for debugging
        try:
            local_errors = self.logs_dir / "pi-errors.log"
            await environment.download_file(_REMOTE_ERRORS, str(local_errors))
            error_content = local_errors.read_text(errors="replace").strip()
            if error_content:
                _LOGGER.info("pi stderr (last 500 chars): %s", error_content[-500:])
        except Exception:
            _LOGGER.debug("Could not download pi error log", exc_info=True)

        if exit_code != 0:
            _LOGGER.error("pi failed with exit code %s", exit_code)
