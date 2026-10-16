/** Tests of the insertion and variant features: the built-in panels and these features registered, as the app does at
 * start (main.tsx). Import first in a test file. */
import '../plugins/builtinPanels';
import { registerInsertionFeatures } from './register';

registerInsertionFeatures();
