"use client";

import { useEffect, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRoundIcon, PlusIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import type { Role } from "@protoloom/core";
import { Alert, AlertDescription, AlertTitle } from "@protoloom/ui/components/alert";
import { Button } from "@protoloom/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@protoloom/ui/components/dialog";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@protoloom/ui/components/form";
import { Input } from "@protoloom/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@protoloom/ui/components/select";
import { Spinner } from "@protoloom/ui/components/spinner";
import { CopyButton } from "@/components/manage/copy-button";
import { EXPIRY_OPTIONS, accessOptionsFor, keyFormSchema, toCreateKeyInput, type KeyFormValues } from "@/lib/api-keys";
import { errorMessage } from "@/lib/trpc-error";
import { useTRPC } from "@/trpc/client";

const emptyRow = { repository: "", groupPrefix: "", access: "read" } as const;
const DEFAULTS: KeyFormValues = { name: "", expiry: "90", permissions: [{ ...emptyRow }] };

/**
 * Create an API key: name, expiry and permission rows (repository, optional group prefix, access
 * limited by the caller's role). On success the secret is shown exactly once; closing the dialog
 * drops it.
 */
export function CreateKeyDialog({ open, onOpenChange, role }: { open: boolean; onOpenChange: (open: boolean) => void; role: Role }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState<{ name: string; key: string } | null>(null);
  const repositories = useQuery({ ...trpc.browse.repositories.queryOptions(), enabled: open });
  const accessOptions = accessOptionsFor(role);

  const form = useForm<KeyFormValues>({ resolver: zodResolver(keyFormSchema), defaultValues: DEFAULTS });
  const rows = useFieldArray({ control: form.control, name: "permissions" });

  useEffect(() => {
    if (open) return;
    // Forget the secret and the input once the dialog is closed.
    setSecret(null);
    form.reset(DEFAULTS);
  }, [open, form]);

  const create = useMutation(
    trpc.keys.create.mutationOptions({
      onSuccess: async ({ key }, input) => {
        setSecret({ name: input.name, key });
        await queryClient.invalidateQueries({ queryKey: trpc.keys.list.queryKey() });
      },
      onError: (error) => toast.error("Couldn't create the key", { description: errorMessage(error) }),
    }),
  );

  const repoNames = repositories.data?.map((r) => r.name) ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-2xl"
        // With the secret on screen, only the explicit Done button closes the dialog.
        onInteractOutside={(event) => secret && event.preventDefault()}
      >
        {secret ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <KeyRoundIcon className="size-4" />
                Key {secret.name} created
              </DialogTitle>
              <DialogDescription>Copy the key now and store it somewhere safe, such as your CI secrets.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <div className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3 sm:flex-row sm:items-center">
                <code data-testid="api-key-secret" className="min-w-0 flex-1 font-mono text-sm break-all select-all">
                  {secret.key}
                </code>
                <CopyButton value={secret.key} toastText="Key copied" />
              </div>
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertTitle>You won&apos;t see this key again</AlertTitle>
                <AlertDescription>
                  Protoloom stores only a hash. If you lose the key, revoke it and create a new one.
                </AlertDescription>
              </Alert>
              <p className="text-xs text-muted-foreground">
                Use it as <code className="font-mono">PROTOLOOM_TOKEN</code> for the CLI and the Gradle plugin, or send it as{" "}
                <code className="font-mono">Authorization: Bearer &lt;key&gt;</code>.
              </p>
            </div>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
              <DialogDescription>
                A key acts on your behalf, limited to the permissions below and to what your role allows.
              </DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit((values) => create.mutate(toCreateKeyInput(values)))} noValidate className="grid gap-5">
                <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_10rem]">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Name</FormLabel>
                        <FormControl>
                          <Input {...field} autoFocus autoComplete="off" placeholder="ci-orders-service" maxLength={32} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="expiry"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Expires after</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {EXPIRY_OPTIONS.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <fieldset className="grid gap-2">
                  <legend className="mb-2 text-sm font-medium">Permissions</legend>
                  <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_2rem] gap-2 text-xs text-muted-foreground sm:grid">
                    <span>Repository</span>
                    <span>Group prefix (optional)</span>
                    <span>Access</span>
                  </div>
                  {rows.fields.map((row, index) => (
                    <div
                      key={row.id}
                      data-testid="permission-row"
                      className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2 rounded-md border p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_2.25rem] sm:items-start sm:border-0 sm:p-0"
                    >
                      <FormField
                        control={form.control}
                        name={`permissions.${index}.repository`}
                        render={({ field }) => (
                          <FormItem className="gap-1">
                            <Select value={field.value} onValueChange={field.onChange}>
                              <FormControl>
                                <SelectTrigger className="w-full font-mono data-[placeholder]:font-sans" aria-label="Repository">
                                  <SelectValue placeholder={repositories.isPending ? "Loading…" : "Choose repository"} />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {repoNames.length === 0 && !repositories.isPending && (
                                  <div className="px-2 py-1.5 text-sm text-muted-foreground">No repositories yet</div>
                                )}
                                {repoNames.map((name) => (
                                  <SelectItem key={name} value={name} className="font-mono">
                                    {name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <FormMessage className="text-xs" />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name={`permissions.${index}.groupPrefix`}
                        render={({ field }) => (
                          <FormItem className="col-span-2 gap-1 sm:col-span-1">
                            <FormControl>
                              <Input
                                {...field}
                                aria-label="Group prefix"
                                placeholder="all groups"
                                autoComplete="off"
                                spellCheck={false}
                                className="font-mono placeholder:font-sans"
                              />
                            </FormControl>
                            <FormMessage className="text-xs" />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name={`permissions.${index}.access`}
                        render={({ field }) => (
                          <FormItem className="col-span-2 gap-1 sm:col-span-1">
                            <Select value={field.value} onValueChange={field.onChange}>
                              <FormControl>
                                <SelectTrigger className="w-full" aria-label="Access">
                                  <SelectValue />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {accessOptions.map((access) => (
                                  <SelectItem key={access} value={access}>
                                    {access}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </FormItem>
                        )}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Remove permission"
                        disabled={rows.fields.length === 1}
                        onClick={() => rows.remove(index)}
                        className="col-start-2 row-start-1 justify-self-end sm:col-start-4"
                      >
                        <XIcon />
                      </Button>
                    </div>
                  ))}
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-fit"
                      disabled={rows.fields.length >= 100}
                      onClick={() => rows.append({ ...emptyRow })}
                    >
                      <PlusIcon />
                      Add permission
                    </Button>
                    <FormDescription className="text-xs">
                      {role === "viewer"
                        ? "As a viewer you can create read-only keys (download only)."
                        : "read: download. write: also publish and delete. A group prefix covers the groups below it too."}
                    </FormDescription>
                  </div>
                  {form.formState.errors.permissions?.root?.message && (
                    <p className="text-sm text-destructive">{form.formState.errors.permissions.root.message}</p>
                  )}
                </fieldset>

                <DialogFooter>
                  <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={create.isPending}>
                    {create.isPending && <Spinner />}
                    Create key
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
