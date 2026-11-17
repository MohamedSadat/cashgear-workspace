// The queries a calendar and a timeline read their rows by (Phase 9), built from the view's own
// (`ViewProps.request`: its filter, sorts and the toolbar's search): the rows whose dates meet the
// days around those shown (a date window, which the server answers for a large database and
// `queryRows` for one on this device), and the rows with no date (a filter `isEmpty` on the date
// property, no window). Groups are not theirs. Pure: no React.
import type { DateWindow, FilterCondition, FilterGroup, PropertyId } from '../../core';
import type { RowRequest } from '../../host';

/** Rows a page of a window's query brings (the server's most). */
export const WINDOW_PAGE = 500;
/** Rows a page of the no-date list brings. */
export const UNDATED_PAGE = 100;

/** The view's filter with a condition that the date property is empty, at the same depth if it can. */
export function withEmpty(filter: FilterGroup | null, propertyId: PropertyId): FilterGroup {
  const empty: FilterCondition = { kind: 'condition', propertyId, operator: 'isEmpty' };
  if (!filter) return { kind: 'group', op: 'and', children: [empty] };
  if (filter.op === 'and') return { ...filter, children: [...filter.children, empty] };
  return { kind: 'group', op: 'and', children: [filter, empty] };
}

/** The view's query cut to a date window. */
export function windowRequest(
  request: RowRequest,
  window: DateWindow,
  pageSize = WINDOW_PAGE,
): RowRequest {
  const { filter, sorts, search } = request.spec;
  return {
    viewId: request.viewId,
    spec: { filter, sorts, group: null, ...(search ? { search } : {}), window },
    pageSize,
  };
}

/** The view's query of the rows with no value in the date property. */
export function undatedRequest(
  request: RowRequest,
  propertyId: PropertyId,
  pageSize = UNDATED_PAGE,
): RowRequest {
  const { filter, sorts, search } = request.spec;
  return {
    viewId: request.viewId,
    spec: {
      filter: withEmpty(filter, propertyId),
      sorts,
      group: null,
      ...(search ? { search } : {}),
    },
    pageSize,
    undated: propertyId,
  };
}
