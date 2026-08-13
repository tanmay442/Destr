// The module-scope side effect is load-bearing: it runs dotenv at bootstrap-module
// evaluation, so entry points must import this module BEFORE any module that reads
// config/env (ESM evaluates imports in order). loadDotEnv() is the idempotent,
// explicit entry-point contract on top of it.
import 'dotenv/config';

let didLoad = false;

export function loadDotEnv(): void {
  if (didLoad) return;
  didLoad = true;
}