import { findUser } from "./user-repository.js";
export function loadUser(id: string) { return findUser(id); }
