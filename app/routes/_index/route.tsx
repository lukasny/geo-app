import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>GEO Rise</h1>
        <p className={styles.text}>
          Make your Shopify store readable and recommendable for AI search
          engines like ChatGPT and Perplexity.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>AI readiness audit</strong>. Scores your products for AI
            discoverability and fixes common gaps in one click.
          </li>
          <li>
            <strong>llms.txt and structured data</strong>. Publishes a public
            llms.txt file and JSON-LD schema so AI crawlers can read your
            catalog.
          </li>
          <li>
            <strong>Citation tracking</strong>. Tracks whether AI assistants
            mention your store when shoppers ask about products like yours.
          </li>
        </ul>
      </div>
    </div>
  );
}
