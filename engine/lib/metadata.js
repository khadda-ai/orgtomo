// Mapping between sfdx source paths and Metadata API component references
// ("Type:Name", the same form "sf project retrieve start --metadata" accepts).

/** Top-level folders: [folder, Metadata type, file suffix]. */
export const FOLDERS = [
  ['classes', 'ApexClass', '.cls'],
  ['triggers', 'ApexTrigger', '.trigger'],
  ['flows', 'Flow', '.flow-meta.xml'],
  ['permissionsets', 'PermissionSet', '.permissionset-meta.xml'],
  ['profiles', 'Profile', '.profile-meta.xml'],
  ['layouts', 'Layout', '.layout-meta.xml'],
  ['flexipages', 'FlexiPage', '.flexipage-meta.xml'],
  ['tabs', 'CustomTab', '.tab-meta.xml'],
  ['labels', 'CustomLabels', '.labels-meta.xml'],
  ['customMetadata', 'CustomMetadata', '.md-meta.xml'],
  ['pages', 'ApexPage', '.page'],
  ['components', 'ApexComponent', '.component'],
  ['staticresources', 'StaticResource', '.resource-meta.xml'],
  ['quickActions', 'QuickAction', '.quickAction-meta.xml'],
  ['globalValueSets', 'GlobalValueSet', '.globalValueSet-meta.xml'],
  ['standardValueSets', 'StandardValueSet', '.standardValueSet-meta.xml'],
  ['reportTypes', 'ReportType', '.reportType-meta.xml'],
  ['applications', 'CustomApplication', '.app-meta.xml'],
  ['sharingRules', 'SharingRules', '.sharingRules-meta.xml'],
  ['queues', 'Queue', '.queue-meta.xml'],
  ['groups', 'Group', '.group-meta.xml'],
  ['customPermissions', 'CustomPermission', '.customPermission-meta.xml'],
  ['namedCredentials', 'NamedCredential', '.namedCredential-meta.xml'],
  ['remoteSiteSettings', 'RemoteSiteSetting', '.remoteSite-meta.xml'],
  // Process and access metadata (folder and suffix as in the Salesforce CLI metadata registry).
  ['approvalProcesses', 'ApprovalProcess', '.approvalProcess-meta.xml'],
  ['assignmentRules', 'AssignmentRules', '.assignmentRules-meta.xml'],
  ['autoResponseRules', 'AutoResponseRules', '.autoResponseRules-meta.xml'],
  ['escalationRules', 'EscalationRules', '.escalationRules-meta.xml'],
  ['workflows', 'Workflow', '.workflow-meta.xml'],
  ['pathAssistants', 'PathAssistant', '.pathAssistant-meta.xml'],
  ['roles', 'Role', '.role-meta.xml'],
  ['permissionsetgroups', 'PermissionSetGroup', '.permissionsetgroup-meta.xml'],
  ['installedPackages', 'InstalledPackage', '.installedPackage-meta.xml'],
  ['duplicateRules', 'DuplicateRule', '.duplicateRule-meta.xml'],
  ['entitlementProcesses', 'EntitlementProcess', '.entitlementProcess-meta.xml'],
  ['connectedApps', 'ConnectedApp', '.connectedApp-meta.xml'],
];
/** Folders whose components are bundles (one folder per component). */
export const BUNDLES = [['lwc', 'LightningComponentBundle'], ['aura', 'AuraDefinitionBundle']];
/** Children of objects/<Object>/: [folder, Metadata type, suffix]. */
export const OBJECT_CHILDREN = [
  ['fields', 'CustomField', '.field-meta.xml'],
  ['validationRules', 'ValidationRule', '.validationRule-meta.xml'],
  ['recordTypes', 'RecordType', '.recordType-meta.xml'],
  ['listViews', 'ListView', '.listView-meta.xml'],
  ['compactLayouts', 'CompactLayout', '.compactLayout-meta.xml'],
  ['webLinks', 'WebLink', '.webLink-meta.xml'],
  ['fieldSets', 'FieldSet', '.fieldSet-meta.xml'],
  ['businessProcesses', 'BusinessProcess', '.businessProcess-meta.xml'],
];

/** "ApexClass:Foo" -> { type, name } */
export function parseRef(ref) {
  const i = String(ref).indexOf(':');
  return { type: ref.slice(0, i), name: ref.slice(i + 1) };
}

/**
 * Component reference for a source file path, or null when the path is not a
 * known metadata file. Works on any path that contains the standard folders.
 */
export function refFromPath(file) {
  const parts = String(file).split('/');
  const oi = parts.lastIndexOf('objects');
  if (oi >= 0 && parts[oi + 1]) {
    const object = parts[oi + 1];
    const rest = parts.slice(oi + 2);
    if (rest.length === 1 && rest[0].endsWith('.object-meta.xml')) return `CustomObject:${object}`;
    for (const [folder, type, suffix] of OBJECT_CHILDREN) {
      if (rest[0] === folder && rest[1]?.endsWith(suffix)) return `${type}:${object}.${rest[1].slice(0, -suffix.length)}`;
    }
    return null;
  }
  for (const [folder, type] of BUNDLES) {
    const i = parts.lastIndexOf(folder);
    if (i >= 0 && parts[i + 1] && parts.length > i + 2) return `${type}:${parts[i + 1]}`;
  }
  for (const [folder, type, suffix] of FOLDERS) {
    const i = parts.lastIndexOf(folder);
    if (i < 0 || !parts[i + 1]) continue;
    const name = parts.slice(i + 1).join('/');
    if (name.endsWith(suffix)) return `${type}:${name.slice(0, -suffix.length)}`;
    if (name.endsWith(`${suffix}-meta.xml`)) return `${type}:${name.slice(0, -(suffix.length + 9))}`;
  }
  return null;
}

/** Glob(s), relative to a package directory, where a component's files live. */
export function sourceGlobsFor(ref) {
  const { type, name } = parseRef(ref);
  if (type === 'CustomObject') return [`objects/${name}/${name}.object-meta.xml`];
  for (const [folder, t, suffix] of OBJECT_CHILDREN) if (t === type) { const [o, n] = name.split('.'); return [`objects/${o}/${folder}/${n}${suffix}`]; }
  for (const [folder, t] of BUNDLES) if (t === type) return [`${folder}/${name}/**`];
  for (const [folder, t, suffix] of FOLDERS) if (t === type) return suffix.endsWith('-meta.xml') ? [`${folder}/${name}${suffix}`] : [`${folder}/${name}${suffix}`, `${folder}/${name}${suffix}-meta.xml`];
  return [];
}

/** Group refs by type for package.xml: { ApexClass: ['A','B'], ... } sorted. */
export function groupByType(refs) {
  const out = {};
  for (const ref of refs) { const { type, name } = parseRef(ref); (out[type] ||= []).push(name); }
  for (const t of Object.keys(out)) out[t] = [...new Set(out[t])].sort();
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** package.xml text for a set of refs. */
export function packageXml(refs, apiVersion) {
  const types = Object.entries(groupByType(refs)).map(([type, names]) =>
    `    <types>\n${names.map((n) => `        <members>${n}</members>`).join('\n')}\n        <name>${type}</name>\n    </types>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${types}\n    <version>${apiVersion}</version>\n</Package>\n`;
}
