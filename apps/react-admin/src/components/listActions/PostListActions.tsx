import {
  CreateButton,
  ExportButton,
  FilterButton,
  TopToolbar,
  useFilterContext,
} from "react-admin";

interface PostListActionsProps {
  create?: boolean;
}

export function PostListActions({ create = true }: PostListActionsProps) {
  const filters = useFilterContext();
  const hasFilters = Array.isArray(filters) && filters.length > 0;

  return (
    <TopToolbar>
      {hasFilters && <FilterButton />}
      {create && <CreateButton />}
      <ExportButton />
    </TopToolbar>
  );
}
