type ModalProps = {
  id: string;
  title: string;
  children: any;
};

export const Modal = ({ id, title, children }: ModalProps) => {
  return (
    <div
      id={id}
      class="fixed inset-0 bg-black bg-opacity-50 dark:bg-opacity-70 z-50 items-center justify-center"
      style="display: none;"
    >
      <div class="bg-white dark:bg-mocha-surface0 border border-gray-200 dark:border-mocha-surface1 p-6 max-w-lg w-11/12">
        <h3 class="text-lg font-semibold mb-3">{title}</h3>
        {children}
      </div>
    </div>
  );
};
