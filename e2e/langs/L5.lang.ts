/** L5：let* 没有了。从 L4 派生。 */

import { derive } from "../../src/nanopass/lang.ts";
import { L4 } from "./L4.lang.ts";

export const L5 = derive({ id: "L5", base: L4, remove: ["LetStar"] });
