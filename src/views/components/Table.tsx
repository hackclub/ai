type TableColumn = {
  header: string;
  key?: string;
  render?: (row: any) => any;
};

type TableProps = {
  columns: TableColumn[];
  data: any[];
  rowClass?: (row: any) => string;
};

export const Table = ({ columns, data, rowClass }: TableProps) => {
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
          {data.map((row, idx) => (
            <tr
              class={`border-b border-brand-border/50 hover:bg-brand-bg/30 transition-colors ${rowClass ? rowClass(row) : ""}`}
            >
              {columns.map((column) => (
                <td class="py-2 px-4 text-sm text-brand-text font-medium">
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
