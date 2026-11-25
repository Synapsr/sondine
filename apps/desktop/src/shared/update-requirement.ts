// Who may sign an update (ADR 045): core checks it when the
// archive arrives and before an install, main right before it replaces the app,
// scripts/update-files.mjs before a release. No import, so a script reads it.

export const UPDATE_TEAM = "P5G8WAJ2G2";
export const UPDATE_BUNDLE_ID = "app.sondine";

/** The designated requirement of every Sondine release: identifier, Developer ID, team. */
export const UPDATE_REQUIREMENT = `identifier "${UPDATE_BUNDLE_ID}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${UPDATE_TEAM}"`;
