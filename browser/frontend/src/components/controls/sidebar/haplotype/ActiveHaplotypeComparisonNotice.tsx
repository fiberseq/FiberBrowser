interface ActiveHaplotypeComparisonNoticeProps {
  onClose: () => void;
}

export function ActiveHaplotypeComparisonNotice({ onClose }: ActiveHaplotypeComparisonNoticeProps) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] text-green-600 dark:text-green-400 font-medium">
        Haplotype comparison active
      </div>
      <button
        onClick={onClose}
        className="text-[11px] text-ink-secondary hover:text-gray-600 hover:underline"
      >
        Close comparison
      </button>
    </div>
  );
}
