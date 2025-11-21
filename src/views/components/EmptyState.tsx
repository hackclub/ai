import { Card } from "./Card";

type EmptyStateProps = {
  message: string;
};

export const EmptyState = ({ message }: EmptyStateProps) => {
  return (
    <Card class="p-8">
      <p class="text-center text-lg font-semibold">{message}</p>
    </Card>
  );
};
