#!/bin/bash
set -euo pipefail

# Only run in remote (Claude Code on the web) environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Install Foundry (forge, cast, anvil)
if ! command -v forge &> /dev/null; then
  mkdir -p "$HOME/.foundry/bin"
  curl -sL https://raw.githubusercontent.com/foundry-rs/foundry/master/foundryup/foundryup -o "$HOME/.foundry/bin/foundryup"
  chmod +x "$HOME/.foundry/bin/foundryup"
  export PATH="$HOME/.foundry/bin:$PATH"
  foundryup
fi

export PATH="$HOME/.foundry/bin:$PATH"

# Install solc 0.8.27 for Foundry (binaries.soliditylang.org is blocked in remote envs)
SOLC_DIR="$HOME/.svm/0.8.27"
if [ ! -f "$SOLC_DIR/solc-0.8.27" ]; then
  mkdir -p "$SOLC_DIR"
  curl -sL https://github.com/ethereum/solidity/releases/download/v0.8.27/solc-static-linux -o "$SOLC_DIR/solc-0.8.27"
  chmod +x "$SOLC_DIR/solc-0.8.27"
fi

# Make Foundry available for the session
echo 'export PATH="$HOME/.foundry/bin:$PATH"' >> "$CLAUDE_ENV_FILE"

# Initialize git submodules (forge-std)
cd "$CLAUDE_PROJECT_DIR"
git submodule update --init --recursive

# Install Node.js dependencies for the fullnode
cd "$CLAUDE_PROJECT_DIR/l2fullnode"
npm install
