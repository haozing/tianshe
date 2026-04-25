import http from 'node:http';

const ORDER_DATA = [
  { id: '1001', title: 'Alpha Lamp', status: 'open', owner: 'Alice' },
  { id: '1002', title: 'Beta Chair', status: 'closed', owner: 'Bob' },
  { id: '1003', title: 'Gamma Desk', status: 'open', owner: 'Carol' },
] as const;

export interface BrowserBusinessCanaryServer {
  baseUrl: string;
  ordersUrl: string;
  detailUrl: (orderId: string) => string;
  apiHits: string[];
  close: () => Promise<void>;
}

function filterOrders(keyword: string, status: string) {
  const normalizedKeyword = keyword.trim().toLowerCase();
  const normalizedStatus = status.trim().toLowerCase();
  return ORDER_DATA.filter((order) => {
    if (normalizedStatus !== 'all' && order.status !== normalizedStatus) {
      return false;
    }
    if (!normalizedKeyword) {
      return true;
    }
    return (
      order.id.toLowerCase().includes(normalizedKeyword) ||
      order.title.toLowerCase().includes(normalizedKeyword) ||
      order.owner.toLowerCase().includes(normalizedKeyword)
    );
  });
}

function renderOrdersPage(title: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 24px; color: #111827; }
      .toolbar { display: grid; grid-template-columns: 1fr 180px auto auto; gap: 12px; align-items: end; }
      .panel { margin-top: 16px; padding: 16px; border: 1px solid #d1d5db; border-radius: 12px; }
      table { width: 100%; border-collapse: collapse; margin-top: 12px; }
      th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #e5e7eb; }
      #orders-summary, #prompt-result { margin-top: 12px; color: #0f766e; }
    </style>
  </head>
  <body>
    <h1 id="orders-title">${title}</h1>
    <div class="toolbar">
      <label>
        Keyword
        <input id="keyword" placeholder="Search order / title / owner" value="" />
      </label>
      <label>
        Status
        <select id="status">
          <option value="all">all</option>
          <option value="open">open</option>
          <option value="closed">closed</option>
        </select>
      </label>
      <button id="apply-filters">Apply Filters</button>
      <a id="export-orders" href="/download/orders.csv" download>Export Orders</a>
    </div>
    <div class="panel">
      <button id="prompt-action">Prompt Action</button>
      <div id="prompt-result">idle</div>
    </div>
    <div class="panel">
      <div id="orders-summary">idle</div>
      <table aria-label="orders table">
        <thead>
          <tr>
            <th>Order</th>
            <th>Title</th>
            <th>Status</th>
            <th>Owner</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody id="orders-body"></tbody>
      </table>
    </div>
    <script>
      const ordersBody = document.getElementById('orders-body');
      const ordersSummary = document.getElementById('orders-summary');
      const promptResult = document.getElementById('prompt-result');

      function renderOrders(items) {
        ordersBody.innerHTML = items
          .map((item) => \`
            <tr class="order-row" data-order-id="\${item.id}">
              <td class="order-id">\${item.id}</td>
              <td class="order-title">\${item.title}</td>
              <td class="order-status">\${item.status}</td>
              <td class="order-owner">\${item.owner}</td>
              <td><a id="detail-link-\${item.id}" class="detail-link" href="/orders/\${item.id}">View Details</a></td>
            </tr>
          \`)
          .join('');
        ordersSummary.textContent = \`\${items.length} result(s)\`;
      }

      async function loadOrders() {
        const keyword = document.getElementById('keyword').value;
        const status = document.getElementById('status').value;
        const response = await fetch(
          \`/api/orders?keyword=\${encodeURIComponent(keyword)}&status=\${encodeURIComponent(status)}\`
        );
        const data = await response.json();
        renderOrders(data.orders);
      }

      document.getElementById('apply-filters').addEventListener('click', async () => {
        console.log('canary-apply-clicked');
        await loadOrders();
      });

      document.getElementById('prompt-action').addEventListener('click', () => {
        const value = prompt('Enter follow-up note', 'follow up');
        promptResult.textContent = value ?? 'cancelled';
      });

      window.addEventListener('DOMContentLoaded', () => {
        console.info('business-canary-ready');
        void loadOrders();
      });
    </script>
  </body>
</html>`;
}

function renderOrderDetailPage(title: string, order: (typeof ORDER_DATA)[number]): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title} Detail ${order.id}</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 24px; color: #111827; }
      .stack { display: grid; gap: 12px; max-width: 680px; }
      .meta { padding: 12px; border: 1px solid #d1d5db; border-radius: 12px; }
      #detail-result { color: #0f766e; }
    </style>
  </head>
  <body>
    <div class="stack">
      <h1 id="detail-title">Order ${order.id}</h1>
      <div id="detail-name" class="meta">${order.title}</div>
      <div id="detail-status" class="meta">${order.status}</div>
      <div id="detail-owner" class="meta">${order.owner}</div>
      <label>
        Follow-up Note
        <textarea id="detail-note"></textarea>
      </label>
      <button id="save-note">Save Note</button>
      <div id="detail-result">idle</div>
    </div>
    <script>
      console.info('business-detail-ready');
      document.getElementById('save-note').addEventListener('click', () => {
        const note = document.getElementById('detail-note').value || 'empty';
        document.getElementById('detail-result').textContent = note;
      });
    </script>
  </body>
</html>`;
}

export async function createBrowserBusinessCanaryServer(options: {
  title: string;
}): Promise<BrowserBusinessCanaryServer> {
  const apiHits: string[] = [];
  const title = options.title;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/orders' || url.pathname === '/') {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(renderOrdersPage(title));
      return;
    }

    if (url.pathname === '/api/orders') {
      apiHits.push(url.pathname + url.search);
      const keyword = url.searchParams.get('keyword') || '';
      const status = url.searchParams.get('status') || 'all';
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ orders: filterOrders(keyword, status) }));
      return;
    }

    if (url.pathname === '/download/orders.csv') {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/csv; charset=utf-8');
      response.setHeader('content-disposition', 'attachment; filename="orders.csv"');
      response.end(
        'id,title,status,owner\n1001,Alpha Lamp,open,Alice\n1002,Beta Chair,closed,Bob\n1003,Gamma Desk,open,Carol\n'
      );
      return;
    }

    if (url.pathname.startsWith('/orders/')) {
      const orderId = url.pathname.split('/').pop() || '';
      const order = ORDER_DATA.find((item) => item.id === orderId);
      if (!order) {
        response.statusCode = 404;
        response.end('order not found');
        return;
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(renderOrderDetailPage(title, order));
      return;
    }

    response.statusCode = 404;
    response.end('not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine business canary server address');
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    ordersUrl: `${baseUrl}/orders`,
    detailUrl: (orderId: string) => `${baseUrl}/orders/${encodeURIComponent(orderId)}`,
    apiHits,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
