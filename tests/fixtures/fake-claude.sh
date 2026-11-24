#!/bin/sh
# Stand-in for `claude` in tests: prints its arguments and sleeps, so a test run never starts a real session.
echo "fake claude $*"
exec sleep 3600
