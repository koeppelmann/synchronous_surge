#!/bin/bash
#
# Native Rollup - Stop Script
#

echo "Stopping Native Rollup services..."

pkill -f "anvil.*8545" 2>/dev/null && echo "  Stopped L1 Anvil"
pkill -f "anvil.*9546" 2>/dev/null && echo "  Stopped L2 Anvil (read-only)"
pkill -f "anvil.*9549" 2>/dev/null && echo "  Stopped L2 Anvil (builder)"
pkill -f "l2-fullnode" 2>/dev/null && echo "  Stopped Fullnode(s)"
pkill -f "deterministic-fullnode" 2>/dev/null && echo "  Stopped legacy Fullnode"
pkill -f "builder.ts" 2>/dev/null && echo "  Stopped Builder"
pkill -f "deterministic-builder" 2>/dev/null && echo "  Stopped legacy Builder"
pkill -f "rpc-proxy" 2>/dev/null && echo "  Stopped RPC Proxies"
pkill -f "python.*8080" 2>/dev/null && echo "  Stopped Frontend"

echo "All services stopped."
