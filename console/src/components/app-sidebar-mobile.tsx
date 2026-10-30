import type { AppStatus } from '@/types';
import { AppSidebar } from '@/components/app-sidebar';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

interface AppSidebarMobileProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  path: string;
  status: AppStatus | null;
}

export function AppSidebarMobile({ open, onOpenChange, path, status }: AppSidebarMobileProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="left-0 top-0 h-dvh w-[288px] max-w-none translate-x-0 translate-y-0 rounded-none border-y-0 border-l-0 p-0 lg:hidden"
        aria-label="主导航"
      >
        <DialogTitle className="sr-only">主导航</DialogTitle>
        <AppSidebar path={path} status={status} onNavigate={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
