// The search field, which ⌘K focuses from anywhere once the Search screen
// is shown.

export const SEARCH_FIELD_ID = "search-field";

export function focusSearchField(): void {
  const field = document.getElementById(SEARCH_FIELD_ID);
  if (!(field instanceof HTMLInputElement)) return;
  field.focus();
  field.select();
}
