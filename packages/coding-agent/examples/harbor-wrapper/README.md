# Harbor Wrapper for Pi

Runs pi as a [Terminal-Bench 2.0](https://tbench.ai) agent via [Harbor](https://github.com/laude-institute/harbor).

## How It Works

The wrapper starts pi in RPC mode as a subprocess, sends the task instruction,
and collects events until the agent finishes. Pi uses its `terminal-bench`
extension for:

- Environment bootstrapping (sandbox snapshot)
- Terminal-Bench-specific prompt optimizations
- Completion verification checklist
- tmux-based terminal interaction (for interactive programs)
- Aggressive output truncation (30KB limit)

## Prerequisites

```bash
# Install pi globally
npm install -g @mariozechner/pi-coding-agent

# Install the terminal-bench extension globally
mkdir -p ~/.pi/agent/extensions
cp ../../examples/extensions/terminal-bench.ts ~/.pi/agent/extensions/

# Install harbor
pip install harbor

# Set your API key
export ANTHROPIC_API_KEY=sk-ant-...
```

## Usage

```bash
# Run on Terminal-Bench 2.0
harbor run \
  --agent-import-path agent:PiAgent \
  -d terminal-bench@2.0 \
  -m anthropic/claude-sonnet-4-20250514 \
  -e runloop \
  -n 20 \
  --n-attempts 5

# Run a single task
harbor run \
  --agent-import-path agent:PiAgent \
  -d terminal-bench@2.0 \
  -m anthropic/claude-sonnet-4-20250514 \
  -t hello-world \
  -n 1 \
  --n-attempts 1

# Use OpenAI models
harbor run \
  --agent-import-path agent:PiAgent \
  -d terminal-bench@2.0 \
  -m openai/gpt-4o \
  -e runloop \
  -n 20
```

## Configuration

The wrapper passes `--terminal-bench --thinking high` to pi by default.
Edit `agent.py` to adjust:

- `--thinking` level (`off`, `low`, `medium`, `high`)
- `--tools` to restrict available tools
- `TASK_TIMEOUT_SEC` for the per-task timeout (default: 30 minutes)

## Architecture

```
Harbor Orchestrator
  │
  ├── Creates sandbox environment (Docker/runloop)
  ├── Calls PiAgent.setup() → starts pi in RPC mode
  ├── Calls PiAgent.run(instruction) → sends prompt via RPC
  │     │
  │     ├── pi receives task via stdin JSON
  │     ├── terminal-bench extension activates:
  │     │   ├── Environment snapshot gathered
  │     │   ├── Guidelines injected into system prompt
  │     │   └── tmux session created
  │     ├── pi's agent loop runs:
  │     │   ├── bash tool for non-interactive commands
  │     │   ├── tmux_send/tmux_read for interactive programs
  │     │   ├── read/write/edit for file operations
  │     │   └── Completion verification on "done" signals
  │     ├── Events streamed back via stdout JSON
  │     └── agent_end event signals completion
  │
  └── PiAgent populates AgentContext (tokens, cost)
```
