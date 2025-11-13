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
    <div class="overflow-x-auto border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 rounded-lg transition-colors">
      <table class="w-full border-collapse">
        <thead>
          <tr class="border-b border-gray-200 dark:border-gray-700">
            {columns.map((column) => (
              <th class="text-left py-3 px-3 font-semibold text-sm">{column.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr class={`border-b border-gray-200 dark:border-gray-700 ${rowClass ? rowClass(row) : ''}`}>
              {columns.map((column) => (
                <td class="py-3 px-3 text-sm">
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
