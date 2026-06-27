#!/usr/bin/env bun
/**
 * `gesetz` CLI entry point.
 *
 * This is a thin wrapper around `@gesetz/cli` so that users who install the
 * `gesetz` package get the `gesetz` binary on their PATH.
 *
 * Usage:
 *   gesetz check
 *   gesetz list
 *   gesetz init
 *   gesetz skill
 */
import { runGesetz } from '@gesetz/cli';

runGesetz();
