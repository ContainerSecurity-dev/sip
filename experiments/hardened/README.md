# Hardened variant

This Dockerfile mirrors the root reference Dockerfile, adding only build/runtime
image arguments for digest pinning. The benchmark runs the root dependency
validator before building. A direct Dockerfile build alone does not enforce
publication age. The existing release workflow and scripts remain the reference
for the full pipeline.
