/**
 * Live-tunable locomotion parameters (docs/research/02 §7). Changed through 'tune' commands so
 * runs stay deterministic and replayable; the panel on the main thread reads these defs.
 */
export interface TuningDef {
  readonly key: TuningKey;
  readonly label: string;
  readonly group: 'Steering' | 'Contacts' | 'Behaviour';
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
}

export type TuningKey =
  | 'avoidHorizon' | 'avoidLookahead' | 'wSep' | 'wAvoid' | 'sideHoldTicks' | 'keepRight'
  | 'idleDampTau' | 'contactIters' | 'stiffness' | 'omega' | 'slackFrac' | 'fleeRadius';

export const TUNING_DEFS: readonly TuningDef[] = [
  { key: 'avoidHorizon', label: 'Avoid horizon (s)', group: 'Steering', min: 0.2, max: 2, step: 0.05, value: 0.8 },
  { key: 'avoidLookahead', label: 'Avoid look-ahead max', group: 'Steering', min: 0.5, max: 6, step: 0.25, value: 3 },
  { key: 'wSep', label: 'Separation weight', group: 'Steering', min: 0, max: 2, step: 0.05, value: 0.6 },
  { key: 'wAvoid', label: 'Avoidance weight', group: 'Steering', min: 0, max: 3, step: 0.05, value: 1 },
  { key: 'sideHoldTicks', label: 'Side hysteresis (ticks)', group: 'Steering', min: 0, max: 60, step: 1, value: 15 },
  { key: 'keepRight', label: 'Keep right (lanes)', group: 'Steering', min: 0, max: 1, step: 1, value: 1 },
  { key: 'idleDampTau', label: 'Idle damping τ (s)', group: 'Contacts', min: 0.02, max: 0.5, step: 0.01, value: 0.1 },
  { key: 'contactIters', label: 'Contact iterations', group: 'Contacts', min: 1, max: 8, step: 1, value: 4 },
  { key: 'stiffness', label: 'Contact stiffness', group: 'Contacts', min: 0.1, max: 1, step: 0.05, value: 0.8 },
  { key: 'omega', label: 'Over-relaxation ω', group: 'Contacts', min: 1, max: 1.9, step: 0.05, value: 1.3 },
  { key: 'slackFrac', label: 'Allowed overlap', group: 'Contacts', min: 0, max: 0.2, step: 0.01, value: 0.03 },
  { key: 'fleeRadius', label: 'Critter flee radius', group: 'Behaviour', min: 0, max: 8, step: 0.25, value: 2.5 },
];

export type Tuning = Record<TuningKey, number>;

export function defaultTuning(): Tuning {
  const t = {} as Tuning;
  for (const d of TUNING_DEFS) t[d.key] = d.value;
  return t;
}
