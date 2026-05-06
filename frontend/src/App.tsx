import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Products from './pages/Products';
import Cohorts from './pages/Cohorts';
import Report from './pages/Report';
import PwTable from './pages/PwTable';

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Products />} />
          <Route path="/pw-table" element={<PwTable />} />
          <Route path="/cohorts" element={<Cohorts />} />
          <Route path="/report" element={<Report />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
