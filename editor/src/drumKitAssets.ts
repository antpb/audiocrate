/**
 * The factory kit's samples as bundled URLs.
 *
 * A hand-written list rather than an import glob: the editor is built by
 * whoever is hosting it, and a glob that silently resolves to nothing gives a
 * drum with no kit and no error. A missing file here is a build failure.
 *
 * `examples/drum/assets/build-kit.mjs` is what produced them.
 */

import kitClap from '../../examples/drum/assets/homecrate_clap.wav?url';
import kitCrash from '../../examples/drum/assets/homecrate_crash.wav?url';
import kitHhcl from '../../examples/drum/assets/homecrate_hhcl.wav?url';
import kitHhopn from '../../examples/drum/assets/homecrate_hhopn.wav?url';
import kitHhpdl from '../../examples/drum/assets/homecrate_hhpdl.wav?url';
import kitHimidtom from '../../examples/drum/assets/homecrate_himidtom.wav?url';
import kitHitom from '../../examples/drum/assets/homecrate_hitom.wav?url';
import kitKick2 from '../../examples/drum/assets/homecrate_kick2.wav?url';
import kitLowtom from '../../examples/drum/assets/homecrate_lowtom.wav?url';
import kitRide from '../../examples/drum/assets/homecrate_ride.wav?url';
import kitRim from '../../examples/drum/assets/homecrate_rim.wav?url';
import kitSnare1 from '../../examples/drum/assets/homecrate_snare1.wav?url';
import kitSnare2 from '../../examples/drum/assets/homecrate_snare2.wav?url';

export const DRUM_KIT_URLS: Record<string, string> = {
  'homecrate_clap.wav': kitClap,
  'homecrate_crash.wav': kitCrash,
  'homecrate_hhcl.wav': kitHhcl,
  'homecrate_hhopn.wav': kitHhopn,
  'homecrate_hhpdl.wav': kitHhpdl,
  'homecrate_himidtom.wav': kitHimidtom,
  'homecrate_hitom.wav': kitHitom,
  'homecrate_kick2.wav': kitKick2,
  'homecrate_lowtom.wav': kitLowtom,
  'homecrate_ride.wav': kitRide,
  'homecrate_rim.wav': kitRim,
  'homecrate_snare1.wav': kitSnare1,
  'homecrate_snare2.wav': kitSnare2,
};
