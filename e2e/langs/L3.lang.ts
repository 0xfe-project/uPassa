/** L3：cond 没有了。从 L2 派生。 */

import { derive } from "../../src/nanopass/lang.ts";
import { L2 } from "./L2.lang.ts";

export const L3 = derive({ id: "L3", base: L2, remove: ["Cond"] });
