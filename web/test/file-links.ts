// Which chat text becomes a link into the Files dock. Run: npx tsx web/test/file-links.ts
// "yes" are real mentions from agent messages; "no" are look-alikes that must stay plain text.
import { isPathLike } from '../src/components/FileLink';
const yes = ['var/review/m13int-{v0,v1,v2,v3-*,v4a,v4b}.log', 'docs/design/page-quality/M13.md:1077', 'e2e/equipment-ops.spec.ts:186',
  'var/review/m13int-v3-equipment-ops.log', 'web/src/app/routes/prerequisites/calibration/ImpactAssessmentScreen.tsx:346',
  'e2e/calibration.spec.ts:577', 'package.json:17', 'shared/test/', 'shared/tsconfig.test.json', 'analysis-report.test.tsx', '/srv/tandem/app/x.ts', './src/index.ts', 'src/**/*.ts', 'README.md'];
const no = ['TrainingRequirement', 'taskOpenPath', 'instrument_id', 'REVIEW-HEAD', 'ec44853', 'exit=0', ':1115', 'role=dialog', '4936175',
  'npx playwright test e2e/equipment-ops.spec.ts --reporter=line', 'invalidateQuery', '제출', '172ac95', 'https://example.com/a.js', 'S13.3',
  'v1.2.3', 'e.g.', 'Node.js', 'a/b', '1/2', 'and/or', 'card.closest', 'npx tsc -b shared/tsconfig.test.json', '--grep-invert'];
let bad = 0;
for (const s of yes) if (!isPathLike(s)) { bad++; console.log('MISSED ', s); }
for (const s of no) if (isPathLike(s)) { bad++; console.log('FALSE+ ', s); }
console.log(bad ? `${bad} wrong` : `all ${yes.length + no.length} classified right`);
process.exitCode = bad ? 1 : 0;
