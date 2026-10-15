import type { ReactElement, ReactNode } from "react";
import { useEffect, useState } from "react";
import type { InferredType, InferredTypeMap } from "ra-core";
import {
  EditBase,
  InferredElement,
  useResourceContext,
  useEditContext,
  getElementsFromRecords,
} from "ra-core";
import { capitalize, singularize } from "inflection";
import { EditView } from "@/components/admin/edit";
import { SimpleForm } from "@/components/admin/simple-form";
import { TextInput } from "@/components/admin/text-input";
import { BooleanInput } from "@/components/admin/boolean-input";
import { ReferenceInput } from "@/components/admin/reference-input";
import { AutocompleteInput } from "@/components/admin/autocomplete-input";
import { ReferenceArrayInput } from "@/components/admin/reference-array-input";

/**
 * An edit page that automatically generates a form from your data.
 *
 * Inspects the record to infer field types and automatically creates appropriate inputs.
 * Useful for rapid prototyping. Logs generated code to console.
 *
 * @see {@link https://marmelab.com/shadcn-admin-kit/docs/edit/#scaffolding-an-edit-page EditGuesser documentation}
 *
 * @example
 * import { Admin, EditGuesser } from '@/components/admin';
 * import { Resource } from 'ra-core';
 * import dataProvider from './dataProvider';
 *
 * const App = () => (
 *   <Admin dataProvider={dataProvider}>
 *     ...
 *     <Resource name="customers" edit={EditGuesser} />
 *   </Admin>
 * );
 */
export const EditGuesser = (props: EditGuesserProps) => {
  return (
    <EditBase>
      <EditViewGuesser {...props} />
    </EditBase>
  );
};

const EditViewGuesser = (props: EditGuesserProps) => {
  const resource = useResourceContext();

  if (!resource) {
    throw new Error(`Cannot use <EditGuesser> outside of a ResourceContext`);
  }

  const { record } = useEditContext();
  const [child, setChild] = useState<ReactNode>(null);
  const { enableLog = process.env.NODE_ENV === "development", ...rest } = props;

  useEffect(() => {
    setChild(null);
  }, [resource]);

  useEffect(() => {
    if (record && !child) {
      const inferredElements = getElementsFromRecords(
        [record],
        editFieldTypes as unknown as InferredTypeMap,
      );
      const inferredChild = new InferredElement(
        editFieldTypes.form as unknown as InferredType,
        null,
        inferredElements,
      );
      setChild(inferredChild.getElement());

      if (!enableLog) return;

      const representation = inferredChild.getRepresentation();

      const components = ["Edit"]
        .concat(
          Array.from(
            new Set(
              Array.from(representation.matchAll(/<([^/\s>]+)/g))
                .map((match) => match[1])
                .filter((component) => component !== "span"),
            ),
          ),
        )
        .sort();

      console.log(
        `Guessed Edit:

${components
  .map(
    (component) =>
      `import { ${component} } from "@/components/admin/${kebabCase(
        component,
      )}";`,
  )
  .join("\n")}

export const ${capitalize(singularize(resource))}Edit = () => (
    <Edit>
${representation}
    </Edit>
);`,
      );
    }
  }, [record, child, resource, enableLog]);

  return <EditView {...rest}>{child}</EditView>;
};

type ComponentProps = {
  source: string;
  reference: string;
  children: ReactElement;
};

interface EditGuesserProps {
  enableLog?: boolean;
}

const editFieldTypes = {
  form: {
    component: (props: ComponentProps) => <SimpleForm {...props} />,
    representation: (
      _props: ComponentProps,
      children: { getRepresentation: () => string }[],
    ) => `        <SimpleForm>
${children
  .map((child) => `            ${child.getRepresentation()}`)
  .join("\n")}
        </SimpleForm>`,
  },
  reference: {
    component: (props: ComponentProps) => (
      <ReferenceInput source={props.source} reference={props.reference}>
        <AutocompleteInput />
      </ReferenceInput>
    ),
    representation: (props: ComponentProps) =>
      `<ReferenceInput source="${props.source}" reference="${props.reference}">
                  <AutocompleteInput />
              </ReferenceInput>`,
  },
  referenceArray: {
    component: (props: ComponentProps) => <ReferenceArrayInput {...props} />,
    representation: (props: ComponentProps) =>
      `<ReferenceArrayInput source="${props.source}" reference="${props.reference}" />`,
  },
  boolean: {
    component: (props: ComponentProps) => <BooleanInput {...props} />,
    representation: (props: ComponentProps) =>
      `<BooleanInput source="${props.source}" />`,
  },
  string: {
    component: (props: ComponentProps) => <TextInput {...props} />,
    representation: (props: ComponentProps) =>
      `<TextInput source="${props.source}" />`,
  },
};

const kebabCase = (name: string) => {
  return name
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
};
