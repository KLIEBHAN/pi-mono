# Harbor Wrapper for Pi

Runs pi as a [Terminal-Bench 2.0](https://tbench.ai) agent via [Harbor](https://github.com/laude-institute/harbor).

## How It Works

The wrapper installs Node.js and pi inside the Harbor sandbox container,
uploads the terminal-bench extension and auth credentials, then runs pi
in print mode (`-p`) for each task. Pi uses its `terminal-bench` extension
for:

- Environment bootstrapping (sandbox snapshot)
- Terminal-Bench-specific prompt optimizations
- Completion verification checklist
- tmux-based terminal interaction (for interactive programs)
- Aggressive output truncation (30KB limit)

## Prerequisites

```bash
# Install harbor
pip install harbor

# The terminal-bench extension must be at one of:
#   ~/.pi/agent/extensions/terminal-bench.ts  (global install)
#   ../extensions/terminal-bench.ts           (relative to this wrapper)
# Copy it if needed:
mkdir -p ~/.pi/agent/extensions
cp ../extensions/terminal-bench.ts ~/.pi/agent/extensions/

# Auth: either API key or subscription login
export ANTHROPIC_API_KEY=sk-ant-...    # Option 1: API key
# OR run `pi` then `/login` to authenticate via subscription (saves to ~/.pi/agent/auth.json)
```

Note: Pi is installed automatically *inside* the sandbox container during
setup. You do NOT need pi installed on the host.

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
  ├── Calls PiAgent.setup():
  │     ├── Installs Node.js + pi in container
  │     ├── Uploads terminal-bench.ts extension
  │     ├── Uploads auth.json (if available)
  │     └── Installs tmux
  ├── Calls PiAgent.run(instruction):
  │     ├── Writes task to /tmp/pi-task.txt in container
  │     ├── Runs `pi -p --terminal-bench ...` in container
  │     │   ├── terminal-bench extension activates:
  │     │   │   ├── Environment snapshot gathered
  │     │   │   ├── Guidelines injected into system prompt
  │     │   │   └── tmux session created
  │     │   ├── pi's agent loop runs:
  │     │   │   ├── bash tool for non-interactive commands
  │     │   │   ├── tmux_send/tmux_read for interactive programs
  │     │   │   ├── read/write/edit for file operations
  │     │   │   └── Completion verification on "done" signals
  │     │   └── pi exits when done
  │     └── Downloads error log for debugging
  │
  └── Harbor runs verifier to score the result
```
