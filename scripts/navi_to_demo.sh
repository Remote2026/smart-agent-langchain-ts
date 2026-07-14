#!/bin/bash
set -euo pipefail

# Mock navigation script for demo/testing.
# Usage: navigate_to.sh <x> <y> <z> <qx> <qy> <qz> <qw>

if [[ $# -lt 7 ]]; then
    echo "Usage: $0 <x> <y> <z> <qx> <qy> <qz> <qw>" >&2
    exit 1
fi

X="$1"
Y="$2"
Z="$3"
QX="$4"
QY="$5"
QZ="$6"
QW="$7"

echo "🧭 Navigating to target pose..."
echo "   Position: ($X, $Y, $Z)"
echo "   Orientation: ($QX, $QY, $QZ, $QW)"

sleep 3

echo "✅ Navigation succeeded."
exit 0
