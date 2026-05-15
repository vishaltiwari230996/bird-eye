import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Products from './pages/Products';
import Cohorts from './pages/Cohorts';
import Report from './pages/Report';
import PwTable from './pages/PwTable';
import Snapshots from './pages/Snapshots';

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Navigate to="/pw-table" replace />} />
          <Route path="/pw-table" element={<PwTable />} />
          <Route path="/snapshots" element={<Snapshots />} />
          <Route path="/products" element={<Products />} />
          <Route path="/cohorts" element={<Cohorts />} />
          <Route path="/report" element={<Report />} />
          <Route path="*" element={<Navigate to="/pw-table" replace />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
