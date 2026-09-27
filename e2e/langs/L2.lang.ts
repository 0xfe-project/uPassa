/** L2：when / unless 没有了。从 L1 派生。 */

import { derive } from "../../src/lang.ts";
import { L1 } from "./L1.lang.ts";

export const L2 = derive({ id: "L2", base: L1, remove: ["When", "Unless"] });
