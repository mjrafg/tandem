#!/bin/sh
# Local development launcher (Node toolchain lives outside the default PATH on this Mac).
export PATH="$HOME/.local/node22/bin:$PATH"
exec npm run dev
