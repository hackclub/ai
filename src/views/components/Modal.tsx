type ModalProps = {
  id: string;
  title: string;
  children: any;
};

export const Modal = ({ id, title, children }: ModalProps) => {
  return (
    <div
      id={id}
      class="fixed inset-0 bg-brand-heading/20 backdrop-blur-sm z-50 items-center justify-center"
      style="display: none;"
    >
      <div class="bg-white border-2 border-brand-border p-8 rounded-3xl max-w-xl w-11/12 shadow-2xl transform transition-all scale-100">
        <h3 class="text-2xl font-bold mb-4 text-brand-heading">{title}</h3>
        {children}
      </div>
    </div>
  );
};
