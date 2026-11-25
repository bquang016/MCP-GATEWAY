import { loadUser } from "./user-service.js";
export function renderUser(id: string) { return loadUser(id).name; }
