/** L4：and / or / not 没有了。从 L3 派生。 */

import { derive } from "../../src/lang.ts";
import { L3 } from "./L3.lang.ts";

export const L4 = derive({ id: "L4", base: L3, remove: ["And", "Or", "Not"] });
