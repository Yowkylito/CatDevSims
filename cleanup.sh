#!/bin/sh
rm -f /workspace/steward/patch-test.py /workspace/steward/patch-test.sh /workspace/steward/write-versions.sh /workspace/steward/versions.txt /workspace/steward/run-cargo-tests.sh
test -d /workspace/steward/.git && echo HASGIT || echo NOGIT
