#!/bin/bash
#
# Native Rollup - Stop Script
#

echo "Stopping Native Rollup services..."

pkill -f "anvil.*8545" 2>/dev/null && echo "  Stopped L1 Anvil"
pkill -f "anvil.*9546" 2>/dev/null && echo "  Stopped L2 Anvil"
pkill -f "deterministic-fullnode" 2>/dev/null && echo "  Stopped Fullnode"
pkill -f "deterministic-builder" 2>/dev/null && echo "  Stopped Builder"
pkill -f "python.*8080" 2>/dev/null && echo "  Stopped Frontend"

echo "All services stopped."
