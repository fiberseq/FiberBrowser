/** Lab tests: register the lab pack (as the app does at start, plugins/packs.ts). Import first in a lab test file. */
import '../plugins/builtinPanels';
import { registerInsertionFeatures } from '../features/register';
import { loadPacks } from '../plugins/packs';

registerInsertionFeatures();
loadPacks();
