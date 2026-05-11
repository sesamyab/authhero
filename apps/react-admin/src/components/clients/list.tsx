import {
  List,
  Datagrid,
  TextField,
  DateField,
  FunctionField,
  TextInput,
} from "react-admin";
import { PostListActions } from "../listActions/PostListActions";
import { useTenantId } from "../../TenantContext";

const filters = [<TextInput key="search" label="Search" source="q" alwaysOn />];

function getTokenBaseUrl(tenantId: string): string {
  const tld = window.location.hostname.endsWith(".com") ? "com" : "dev";
  return `https://${tenantId}.token.sesamy.${tld}`;
}

export function ClientList() {
  const tenantId = useTenantId();
  const baseUrl = tenantId ? getTokenBaseUrl(tenantId) : null;
  return (
    <List actions={<PostListActions />} filters={filters}>
      <Datagrid rowClick="edit" bulkActionButtons={false}>
        <TextField source="id" />
        <TextField source="name" />
        <FunctionField
          label="Login"
          render={(record: any) =>
            baseUrl ? (
              <a
                href={`${baseUrl}/authorize?client_id=${record.id}&redirect_uri=${baseUrl}/u/info&scope=profile%20email%20openid&state=1234&response_type=code`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Login
              </a>
            ) : null
          }
        />
        <DateField source="created_at" showTime={true} />
        <DateField source="updated_at" showTime={true} />
      </Datagrid>
    </List>
  );
}
