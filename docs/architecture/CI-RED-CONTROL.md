---
title: CI RED control
---

# CI RED control

This page exists for a moment to prove the PR build gate fails on a real defect.
The construct below is the one from noetl/ai-meta#364 — an MDX explicit heading
id, which micromark/acorn rejects and which took the build from exit 0 to exit 1.

## A heading with an explicit id {#deliberately-broken-mdx}

Reverted immediately after the run.
