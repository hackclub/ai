import type { Child } from "hono/jsx";

type TableColumn<T> = {
  header: string;
  key?: keyof T;
  render?: (row: T) => Child;
};

type TableProps<T> = {
  columns: TableColumn<T>[];
  data: T[];
  rowClass?: (row: T) => string;
};

export const Table = <T,>({ columns, data, rowClass }: TableProps<T>) => {
  return (
    <div class="overflow-x-auto border-2 border-brand-border bg-white rounded-2xl shadow-sm transition-colors">
      <table class="w-full border-collapse">
        <thead>
          <tr class="border-b-2 border-brand-border bg-brand-bg/50">
            {columns.map((column) => (
              <th class="text-left py-4 px-4 font-bold text-sm text-brand-heading uppercase tracking-wider">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, _idx) => (
            <tr
              class={`border-b border-brand-border/50 hover:bg-brand-bg/30 transition-colors ${rowClass ? rowClass(row) : ""}`}
            >
              {columns.map((column) => (
                <td class="py-2 px-4 text-sm text-brand-text font-medium">
                  {/* biome-ignore lint/style/noNonNullAssertion: TODO */}
                  {column.render ? column.render(row) : row[column.key!]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
