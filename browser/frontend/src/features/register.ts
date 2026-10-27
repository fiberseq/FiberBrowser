import { useBrowserStore } from '../stores/browserStore';
import { updateSvCorrespondences } from '../utils/svCorrespondence';
import { registerEquivalentClustering } from '../utils/equivalentClustering';
/**
 * The insertion and variant features: the insertion lens with Identify and the Variants panel (SNPs, combinations,
 * multi-SV and mixed SNP+SV splits), both supported, and the Preview feature alt-allele (insert-expanded) panels
 * (utils/previewFeatures). A core module that registers through the same extension points a plugin pack uses
 * (ARCHITECTURE.md), so these features reach core only through them; called once from main.tsx.
 */
import './types';
import { registerInsertionLens } from './insertion/register';
import { registerVariants } from './variants/register';
import { registerAltAllele } from './altAllele/register';
import { registerAltAllelePreview } from './altAllele/preview';
import { registerLiveLift } from './liveLift/register';
import { registerGraphPanel } from './graphPanel/register';
import { registerFeatureHub } from './hub/register';

let done = false;

export function registerInsertionFeatures(): void {
  if (done) return;
  done = true;
  registerEquivalentClustering();
  useBrowserStore.subscribe((s, previous) => {
    if (s.panels === previous.panels && s.svSplits === previous.svSplits) return;
    updateSvCorrespondences(s);
  });
  registerAltAllelePreview();
  registerInsertionLens();
  registerVariants();
  registerAltAllele();
  registerLiveLift();
  registerGraphPanel();
  registerFeatureHub();
}
