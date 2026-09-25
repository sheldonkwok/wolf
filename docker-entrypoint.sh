#!/bin/sh
set -eu

mkdir -p /data
chown bun:bun /data
exec gosu bun "$@"
