import type { Child } from "hono/jsx";

export const Layout = ({
  children,
  title,
}: {
  children: Child;
  title: string;
}) => {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{title}</title>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="icon" type="image/png" href="/favicon.png" />
        <link rel="icon" href="/favicon.ico" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossorigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <script src="https://cdn.tailwindcss.com?plugins=typography"></script>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              tailwind.config = {
                theme: {
                  extend: {
                    fontFamily: {
                      sans: ['Google Sans', 'ui-sans-serif', 'system-ui', 'sans-serif'],
                    },
                    colors: {
                      brand: {
                        bg: '#FFF3EB',
                        primary: '#EC3750',
                        heading: '#4D000B',
                        text: '#A67E85',
                        'primary-hover': '#D62640',
                        'surface': '#FFFFFF',
                        'border': '#F0D4D8',
                      }
                    },
                    borderRadius: {
                      'xl': '1rem',
                      '2xl': '1.5rem',
                      '3xl': '2rem',
                    }
                  }
                }
              }
            `,
          }}
        />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              @view-transition {
                navigation: auto;
              }
            `,
          }}
        />
      </head>
      <body class="bg-brand-bg text-brand-text transition-colors duration-200 min-h-screen flex flex-col">
        {children}
      </body>
    </html>
  );
};
