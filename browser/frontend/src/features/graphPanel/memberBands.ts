/**
 * A host's read bands by member (DESIGN_GRAPH_PRIMARY §1.1, §3.2–3.3; graph primary G3): under each path's lane, one
 * sub-band per member panel bound to that path, in member order. Every sub-band reads its own member's state
 * (stateKey): exclusions, id filters, cluster focus, then its order — the member's sort if it has one, else its
 * clusters (grouped, unassigned last), else by first drawn base (or length). The same molecule shown by two members
 * (two copies of a dataset with different filters) is drawn in both, each under its own rules.
 *
 * Rows find their member's state through the row's identities: QNAME (selections, exclusions and "keep only" sets
 * are QNAMEs in every view), its `analysis_id`, and its record key (utils/recordKeys.ts) for state another view wrote
 * by `analysis_id` (cluster assignments, server filter results, sort orders).
 */
import type { GraphRead } from './types';
import type { PackedLane, PlacedMolecule } from './readGeometry';
import { idSetHas, orderIndex, recordValueIndex } from '../../utils/recordKeys';
import { UNASSIGNED_CLUSTER_ID } from '../../components/tracks/read-track/constants';

export interface BandMember {
  panelId: string;
  stateKey: string;
  datasetId: string;
  /** A split lifted panel's haplotype (its rows only); null: every haplotype of the dataset. */
  liftHap: string | null;
  /** The package path it is bound to; null: every path its dataset binds. */
  binding: string | null;
  label: string;
  color: string;
}

export interface MemberState {
  assignments?: Readonly<Record<string, number>>;
  clusterOrder?: readonly number[];
  focus?: ReadonlySet<number> | null;
  filter?: ReadonlySet<string> | null;
  sort?: readonly string[];
  excluded?: ReadonlySet<string>;
}

export interface BandGroup {
  memberId: string;
  label: string;
  color: string;
  startRow: number;
  rowCount: number;
  /** Records this member shows on the path (drawn and over the row limit). */
  reads: number;
  hidden: number;
  /** How its rows are ordered ('sort': the member's sort order, 'cluster', 'position', 'length'). */
  order: 'sort' | 'cluster' | 'position' | 'length';
}

/** A host lane: its rows, which member and cluster each row is (-1 unassigned; null: the member has no clusters),
 * and its member groups. */
export interface HostLane extends PackedLane { rowMember: string[]; rowCluster: (number | null)[]; groups: BandGroup[] }

/** Whether a graph row is one of a member's rows (its dataset, haplotype and path). */
export function routeRead(r: GraphRead, m: BandMember): boolean {
  if (r.d !== m.datasetId) return false;
  if (m.binding && r.b !== m.binding) return false;
  if (m.liftHap && (r.hap ?? '').toUpperCase() !== m.liftHap.toUpperCase()) return false;
  return true;
}

/** A graph row's identities for id sets: QNAME, `analysis_id` (lifted). */
export const rowKeys = (r: GraphRead): string[] => (r.aid ? [r.q, r.aid] : [r.q]);

/** A graph row's cluster in a member's assignments: its own identity, else its record's (the primary placement's
 * lowest row: §3.1 display precedence); native rows by QNAME. */
export function clusterOf(r: GraphRead, assignments: Readonly<Record<string, number>> | undefined): number | undefined {
  if (!assignments) return undefined;
  if (r.aid && assignments[r.aid] !== undefined) return assignments[r.aid];
  if (!r.aid && assignments[r.q] !== undefined) return assignments[r.q];
  if (r.rk) {
    const v = recordValueIndex(assignments).get(r.rk);
    if (v !== undefined) return v;
  }
  return undefined;
}

const bodyBp = (m: PlacedMolecule) => m.body.reduce((t, b) => t + (b.s1 - b.s0), 0);

/** First-fit rows for molecules in the given order (x extents), at most `maxRows`; the rest counted hidden. */
function firstFit(list: PlacedMolecule[], maxRows: number, gapPx: number, oneEach = false): { rows: PlacedMolecule[][]; hidden: number } {
  const rows: PlacedMolecule[][] = [];
  const ends: number[] = [];
  let hidden = 0;
  for (const m of list) {
    let r = oneEach ? -1 : ends.findIndex(e => e + gapPx <= m.extent![0]);
    if (r < 0) {
      if (rows.length >= maxRows) { hidden++; continue; }
      r = rows.length; rows.push([]); ends.push(-Infinity);
    }
    rows[r].push(m);
    ends[r] = Math.max(ends[r], m.extent![1]);
  }
  return { rows, hidden };
}

/** The host's lanes: per path, its members' sub-bands in member order. */
export function packMemberBands(molecules: readonly PlacedMolecule[], members: readonly BandMember[],
  states: Readonly<Record<string, MemberState>>, maxRows: number, bandSort: 'position' | 'length' = 'position', gapPx = 3): Map<string, HostLane> {
  const byLane = new Map<string, PlacedMolecule[]>();
  for (const m of molecules) {
    if (!m.extent) continue;
    const list = byLane.get(m.lane);
    if (list) list.push(m); else byLane.set(m.lane, [m]);
  }
  const lanes = new Map<string, HostLane>();
  for (const [laneKey, onLane] of byLane) {
    const lane: HostLane = { lane: laneKey, rows: [], hidden: 0, rowMember: [], rowCluster: [], groups: [] };
    for (const member of members) {
      const st = states[member.panelId] ?? {};
      let list = onLane.filter(m => routeRead(m.read, member));
      if (!list.length) continue;
      if (st.excluded?.size) list = list.filter(m => !st.excluded!.has(m.read.q));
      if (st.filter) list = list.filter(m => idSetHas(st.filter!, rowKeys(m.read), m.read.rk));
      const clustered = Boolean(st.assignments && Object.keys(st.assignments).length);
      const clusterOfRead = new Map<PlacedMolecule, number | null>();
      for (const m of list) {
        const c = clustered ? clusterOf(m.read, st.assignments) : undefined;
        clusterOfRead.set(m, c === undefined || c === UNASSIGNED_CLUSTER_ID ? null : c);
      }
      if (st.focus?.size) list = list.filter(m => { const c = clusterOfRead.get(m); return c != null && st.focus!.has(c); });
      const tie = (a: PlacedMolecule, b: PlacedMolecule) => (bandSort === 'length' ? bodyBp(b) - bodyBp(a) : 0)
        || a.extent![0] - b.extent![0] || a.read.k.localeCompare(b.read.k);
      const reads = list.length;
      let order: BandGroup['order'] = bandSort;
      let packed: { rows: PlacedMolecule[][]; hidden: number; clusters: (number | null)[] };
      if (st.sort?.length) {
        // The member's sort order (a site or rule sort, by any of the row's identities): one row per read, in it.
        order = 'sort';
        const idx = orderIndex(st.sort);
        const rank = (m: PlacedMolecule) => idx.get(m.read.q) ?? (m.read.aid ? idx.get(m.read.aid) : undefined)
          ?? (m.read.rk ? idx.get(m.read.rk) : undefined) ?? Number.MAX_SAFE_INTEGER;
        list = [...list].sort((a, b) => rank(a) - rank(b) || tie(a, b));
        const ff = firstFit(list, maxRows, gapPx, true);
        packed = { ...ff, clusters: ff.rows.map(r => (clustered ? clusterOfRead.get(r[0]) ?? UNASSIGNED_CLUSTER_ID : null)) };
      } else if (clustered) {
        // Grouped by cluster in the member's cluster order, unassigned last; rows never mix clusters.
        order = 'cluster';
        const rankOf = new Map((st.clusterOrder ?? []).map((c, i) => [c, i] as const));
        const groups = new Map<number | null, PlacedMolecule[]>();
        for (const m of list) {
          const c = clusterOfRead.get(m) ?? null;
          const g = groups.get(c);
          if (g) g.push(m); else groups.set(c, [m]);
        }
        const keys = [...groups.keys()].sort((a, b) => (a == null ? 1 : 0) - (b == null ? 1 : 0)
          || (rankOf.get(a ?? -1) ?? 1e9) - (rankOf.get(b ?? -1) ?? 1e9) || (a ?? 0) - (b ?? 0));
        packed = { rows: [], hidden: 0, clusters: [] };
        for (const c of keys) {
          const ff = firstFit(groups.get(c)!.sort(tie), maxRows - packed.rows.length, gapPx);
          packed.rows.push(...ff.rows);
          packed.clusters.push(...ff.rows.map(() => c ?? UNASSIGNED_CLUSTER_ID));
          packed.hidden += ff.hidden;
        }
      } else {
        const ff = firstFit([...list].sort(tie), maxRows, gapPx);
        packed = { ...ff, clusters: ff.rows.map(() => null) };
      }
      lane.groups.push({ memberId: member.panelId, label: member.label, color: member.color, startRow: lane.rows.length,
        rowCount: packed.rows.length, reads, hidden: packed.hidden, order });
      lane.rows.push(...packed.rows);
      lane.rowMember.push(...packed.rows.map(() => member.panelId));
      lane.rowCluster.push(...packed.clusters);
      lane.hidden += packed.hidden;
    }
    if (lane.groups.length) lanes.set(laneKey, lane);
  }
  return lanes;
}
