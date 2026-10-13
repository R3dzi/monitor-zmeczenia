import { RULES } from './rules.config';
import type { Measurement } from './types';
import { HR_COUNT } from './validate';

export type TestStatus = 'pass' | 'fail' | 'missing';
export type DayColor = 'green' | 'yellow' | 'orange' | 'red' | 'gray';
export type TestKey = 'hrv' | 'bodyBattery' | 'ssz' | 'morningRun';

export interface Evaluation {
  tests: Record<TestKey, TestStatus>;
  passed: number;
  completed: number;
  total: 4;
  color: DayColor;
  avgHr: number | null;
  drift: number | null;
}

type Input = Pick<Measurement, 'hrv' | 'bodyBattery' | 'ssz' | 'morningRun'>;

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Status testów, liczba zaliczonych i kolor dnia są ZAWSZE wyliczane z surowych
 * wartości – nigdy nie są czytane z zapisanych/importowanych danych.
 */
export function evaluate(m: Input): Evaluation {
  const t = RULES.thresholds;

  const hrv: TestStatus = m.hrv === null ? 'missing' : m.hrv >= t.hrv.min ? 'pass' : 'fail';
  const bodyBattery: TestStatus =
    m.bodyBattery === null ? 'missing' : m.bodyBattery >= t.bodyBattery.min ? 'pass' : 'fail';
  const ssz: TestStatus = m.ssz === null ? 'missing' : m.ssz <= t.ssz.max ? 'pass' : 'fail';

  let morningRun: TestStatus = 'missing';
  let avgHr: number | null = null;
  let drift: number | null = null;
  const hr = m.morningRun.hr;
  const complete =
    m.morningRun.pace !== null && hr.length === HR_COUNT && hr.every((v) => v !== null);
  if (complete) {
    const vals = hr as number[];
    avgHr = mean(vals);
    drift = mean(vals.slice(HR_COUNT / 2)) - mean(vals.slice(0, HR_COUNT / 2));
    morningRun = avgHr <= t.morningRun.maxAvgHr && drift <= t.morningRun.maxDrift ? 'pass' : 'fail';
  }

  const tests = { hrv, bodyBattery, ssz, morningRun };
  const statuses = Object.values(tests);
  const passed = statuses.filter((s) => s === 'pass').length;
  const completed = statuses.filter((s) => s !== 'missing').length;

  let color: DayColor = 'gray';
  if (completed > 0) {
    color = RULES.colors.find((c) => passed >= c.minPassed)?.color ?? 'red';
  }
  return { tests, passed, completed, total: 4, color, avgHr, drift };
}

export const COLOR_LABEL: Record<DayColor, string> = {
  green: 'Zielony',
  yellow: 'Żółty',
  orange: 'Pomarańczowy',
  red: 'Czerwony',
  gray: 'Brak danych',
};

export const TEST_LABEL: Record<TestKey, string> = {
  hrv: 'HRV',
  bodyBattery: 'Body Battery',
  ssz: 'SSZ',
  morningRun: 'Morning Run Test',
};
