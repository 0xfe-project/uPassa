/** L6 = Lcore：糖全没了，解释器就在这门语言上跑。从 L5 派生。 */

import { derive } from "../../src/lang.ts";
import { L5 } from "./L5.lang.ts";

export const L6 = derive({ id: "L6", base: L5, remove: ["IfAlt"] });
