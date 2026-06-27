#!/usr/bin/env bun
/**
 * `regel` CLI entry point.
 *
 * This is a thin wrapper around `@regeln/cli` so that users who install the
 * `regel` package get the `regel` binary on their PATH.
 *
 * Usage:
 *   regel check
 *   regel list
 *   regel init
 *   regel skill
 */
import { runRegel } from '@regeln/cli';

runRegel();
