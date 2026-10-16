import type { BrowserState } from '../stores/browserStore';
import type { ClusterBasis, ClusterTargetPlan, PlanState } from './clusterTargets';

type Run = (state: BrowserState, basis: ClusterBasis, report: (tone: 'error' | 'note' | 'done', text: string, panelIds?: string[]) => void) => Promise<void>;
const runners = new Map<string, Run>();
/** Packs can execute a specialized basis through the normal Cluster button. */
export function registerClusterBasisRunner(kind: string, run: Run) { runners.set(kind, run); }
export function clusterBasisRunner(kind: string) { return runners.get(kind); }

type PlanTransform = (state: PlanState, plan: ClusterTargetPlan) => ClusterTargetPlan;
const planners: PlanTransform[] = [];
export function registerClusterPlanTransform(transform: PlanTransform) { planners.push(transform); }
export function extendClusterPlan(state: PlanState, plan: ClusterTargetPlan) { return planners.reduce((p, transform) => transform(state, p), plan); }
