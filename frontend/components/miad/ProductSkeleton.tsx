import { Skeleton } from "@/components/ui/skeleton"

export function ProductSkeleton() {
  return (
    <div className="flex flex-col space-y-3 p-4 border rounded-3xl bg-white">
      <Skeleton className="h-50 w-full rounded-2xl bg-slate-100" />
      <div className="space-y-2">
        <Skeleton className="h-4 w-[150px] bg-slate-100" />
        <Skeleton className="h-4 w-[100px] bg-slate-100" />
      </div>
      <div className="flex justify-between items-center mt-4">
        <Skeleton className="h-6 w-16 bg-slate-100" />
        <Skeleton className="h-10 w-24 rounded-xl bg-slate-100" />
      </div>
    </div>
  )
}