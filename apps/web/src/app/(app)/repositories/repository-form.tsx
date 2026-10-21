"use client";

import { useEffect, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { GlobeIcon, LockIcon } from "lucide-react";
import { Button } from "@protoloom/ui/components/button";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@protoloom/ui/components/form";
import { Input } from "@protoloom/ui/components/input";
import { RadioGroup, RadioGroupItem } from "@protoloom/ui/components/radio-group";
import { Spinner } from "@protoloom/ui/components/spinner";
import { Switch } from "@protoloom/ui/components/switch";
import { Textarea } from "@protoloom/ui/components/textarea";
import { REPOSITORY_NAME_HINT } from "@/lib/names";
import { repositorySettingsSchema, type RepositorySettingsValues } from "@/lib/repository-settings";

/** One settings row: label and explanation on the left, the control on the right (stacked on phones). */
function SettingRow({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-8">{children}</div>;
}

const VISIBILITY = [
  {
    value: "public",
    icon: GlobeIcon,
    title: "Public",
    description: "Anyone can download over the REST API without a key, and browse it in the UI when anonymous view is on.",
  },
  {
    value: "private",
    icon: LockIcon,
    title: "Private",
    description: "Only signed-in users and API keys with a permission on this repository can see it.",
  },
] as const;

/**
 * The General settings of a repository, for creating one (`mode="create"`, with the name input)
 * or editing one. `onSubmit` receives validated values; the caller runs the mutation.
 */
export function RepositoryForm({
  mode,
  defaultValues,
  onSubmit,
  submitting,
  footer,
}: {
  mode: "create" | "edit";
  defaultValues: RepositorySettingsValues;
  onSubmit: (values: RepositorySettingsValues) => Promise<unknown>;
  submitting: boolean;
  /** Extra buttons next to the submit button (e.g. Cancel). */
  footer?: ReactNode;
}) {
  const form = useForm<RepositorySettingsValues>({ resolver: zodResolver(repositorySettingsSchema), defaultValues });
  const dirty = form.formState.isDirty;

  // Take newer server values (a refetch after a save elsewhere) unless the user is editing.
  const serverValues = JSON.stringify(defaultValues);
  useEffect(() => {
    if (!form.formState.isDirty) form.reset(JSON.parse(serverValues) as RepositorySettingsValues);
  }, [serverValues, form]);

  async function submit(values: RepositorySettingsValues) {
    try {
      await onSubmit(values);
      if (mode === "edit") form.reset(values);
    } catch {
      // The caller reports the error; keep the input as typed.
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submit)} noValidate className="rounded-md border">
        <div className="divide-y">
          {mode === "create" && (
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem className="px-4 py-4">
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input {...field} autoFocus autoComplete="off" spellCheck={false} placeholder="team-private" className="max-w-sm font-mono" />
                  </FormControl>
                  <FormDescription>{REPOSITORY_NAME_HINT} It can't be changed later.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          <FormField
            control={form.control}
            name="description"
            render={({ field }) => (
              <FormItem className="px-4 py-4">
                <FormLabel>Description</FormLabel>
                <FormControl>
                  <Textarea {...field} rows={2} placeholder="What lives here, who owns it" className="resize-y" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="visibility"
            render={({ field }) => (
              <FormItem className="px-4 py-4">
                <FormLabel>Visibility</FormLabel>
                <FormControl>
                  <RadioGroup value={field.value} onValueChange={field.onChange} className="grid gap-2 sm:grid-cols-2">
                    {VISIBILITY.map((option) => (
                      <label
                        key={option.value}
                        className="flex cursor-pointer gap-3 rounded-md border p-3 transition-colors hover:bg-muted/50 has-data-[state=checked]:border-foreground has-data-[state=checked]:bg-muted/40"
                      >
                        <RadioGroupItem value={option.value} aria-label={option.title} className="mt-0.5" />
                        <span className="grid gap-1">
                          <span className="flex items-center gap-1.5 text-sm font-medium">
                            <option.icon className="size-3.5 text-muted-foreground" />
                            {option.title}
                          </span>
                          <span className="text-xs text-muted-foreground">{option.description}</span>
                        </span>
                      </label>
                    ))}
                  </RadioGroup>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="allowReleases"
            render={({ field }) => (
              <FormItem>
                <SettingRow>
                  <div className="grid gap-1">
                    <FormLabel>Accept releases</FormLabel>
                    <FormDescription className="text-xs">Versions without the -SNAPSHOT suffix, e.g. 1.4.0.</FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </SettingRow>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="allowSnapshots"
            render={({ field }) => (
              <FormItem>
                <SettingRow>
                  <div className="grid gap-1">
                    <FormLabel>Accept snapshots</FormLabel>
                    <FormDescription className="text-xs">
                      -SNAPSHOT versions, e.g. 1.5.0-SNAPSHOT. Every publish adds a new build.
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </SettingRow>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="allowRedeploy"
            render={({ field }) => (
              <FormItem>
                <SettingRow>
                  <div className="grid gap-1">
                    <FormLabel>Allow redeploy</FormLabel>
                    <FormDescription className="text-xs">
                      Lets a publish replace an existing release version. Off by default: a published release is immutable, so
                      everyone who fetched 1.4.0 keeps getting the same files. Snapshots are not affected. Versions that other
                      artifacts depend on still can't be replaced.
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </SettingRow>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="resolutionPriority"
            render={({ field }) => (
              <FormItem>
                <SettingRow>
                  <div className="grid gap-1">
                    <FormLabel>Resolution priority</FormLabel>
                    <FormDescription className="text-xs">
                      Lower wins. When a dependency exists in several repositories, it is resolved from the repository with the
                      lowest number.
                    </FormDescription>
                    <FormMessage />
                  </div>
                  <FormControl>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step={1}
                      className="w-28 font-mono tabular-nums"
                      name={field.name}
                      ref={field.ref}
                      onBlur={field.onBlur}
                      value={Number.isNaN(field.value) ? "" : field.value}
                      onChange={(event) => field.onChange(event.target.valueAsNumber)}
                    />
                  </FormControl>
                </SettingRow>
              </FormItem>
            )}
          />
        </div>

        <div className="flex items-center justify-end gap-2 border-t bg-muted/30 px-4 py-3">
          {footer}
          <Button type="submit" size="sm" disabled={submitting || (mode === "edit" && !dirty)}>
            {submitting && <Spinner />}
            {mode === "create" ? "Create repository" : "Save changes"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
